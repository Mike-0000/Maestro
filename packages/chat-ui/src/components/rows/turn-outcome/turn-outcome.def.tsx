import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import { Show } from 'solid-js';
import type { TurnOutcomeItem } from '@/model';
import {
  outcomeError,
  outcomeErrorDot,
  outcomeQuiet,
  outcomeRow,
  outcomeText,
} from './turn-outcome.css';

function outcomeLabel(item: TurnOutcomeItem): string {
  const reason = item.outcome.reason ? ` (${item.outcome.reason})` : '';
  switch (item.outcome.kind) {
    case 'cancelled':
      return `Turn cancelled${reason}`;
    case 'error':
      return `Turn failed${reason}`;
    case 'interrupted':
      return `Turn interrupted${reason}`;
    case 'done':
      return `Turn completed${reason}`;
    default:
      return `Turn finished${reason}`;
  }
}

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const failed = () => props.data.outcome.kind === 'error';
    return (
      <div
        class={`${outcomeRow} ${failed() ? outcomeError : outcomeQuiet}`}
        style={{ height: `${props.vars.rowH}px` }}
        // Not an alert: virtualised rows remount on scroll and would announce again.
        role={failed() ? undefined : 'separator'}
        aria-label={failed() ? undefined : outcomeLabel(props.data)}
        title={outcomeLabel(props.data)}
      >
        <Show when={failed()}>
          <span class={outcomeErrorDot} aria-hidden="true" />
        </Show>
        <span class={outcomeText}>{outcomeLabel(props.data)}</span>
      </div>
    );
  },
});
