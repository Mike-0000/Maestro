/**
 * Tool — minimal single-row renderer for generic ChatToolCall items.
 *
 * Used as the desktop fallback for ACP tool kinds without a dedicated renderer
 * (search, fetch, think, other). Consistent with the file-op / execute style:
 * a plain text row with no badge, no collapse, no detail view. Status shows
 * only when the developer must notice it: "Failed" or "Needs permission".
 *
 * Shimmer applied while status === 'running'.
 *
 * Outer geometry (height, padding) is applied by tool.def.ts Render.
 * This component only describes inner content.
 */

import { StatusMark } from '@components/primitives/StatusMark';
import { Show } from 'solid-js';
import type { ChatToolCall } from '@/model';
import { textShimmer, toolName, toolRow, toolSummary } from './tool.css';

export type ToolProps = {
  item: ChatToolCall;
};

export function Tool(props: ToolProps) {
  const isRunning = () => props.item.status === 'running' && !props.item.awaitingPermission;
  return (
    <div class={toolRow}>
      <span class={toolName} classList={{ [textShimmer]: isRunning() }}>
        {props.item.name}
      </span>
      <Show when={props.item.inputSummary}>
        <span class={toolSummary} classList={{ [textShimmer]: isRunning() }}>
          {props.item.inputSummary}
        </span>
      </Show>
      <StatusMark
        awaitingPermission={props.item.awaitingPermission}
        error={props.item.status === 'error'}
        errorTitle={props.item.error}
      />
    </div>
  );
}
