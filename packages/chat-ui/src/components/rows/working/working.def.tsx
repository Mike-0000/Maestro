import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import type { WorkingItem } from '@/model';
import { workingRow } from './working.css';
import { workingDot } from '@styles/effects.css';

export const workingUnitDef = defineUnit<WorkingItem, { rowH: number }>({
  kind: 'working',
  margin: { top: 2, bottom: 2 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    return (
      <div class={workingRow} style={{ height: `${props.vars.rowH}px` }}>
        <span class={workingDot} aria-hidden="true" />
        <span>Working…</span>
      </div>
    );
  },
});
