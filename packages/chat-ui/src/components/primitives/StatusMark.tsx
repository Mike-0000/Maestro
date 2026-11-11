/**
 * StatusMark — the right-hand status of a tool row, in a glyph and words.
 *
 * Tool rows are quiet (passive text, no badges); the only status they show is
 * the one the developer must notice: a failure ("Failed", error tone) or a step
 * waiting on their permission ("Needs permission", warning tone). Nothing is
 * rendered otherwise. The error message stays available as the native tooltip.
 */

import { Show } from 'solid-js';
import { IconError, IconShieldAlert } from './icons';
import { statusMarkError, statusMarkWarning } from './status-mark.css';

export type StatusMarkProps = {
  /** Waiting on the developer's permission. Takes precedence over `error`. */
  awaitingPermission?: boolean;
  /** The step failed. */
  error?: boolean;
  /** Tooltip for the failure (the error message); defaults to "Failed". */
  errorTitle?: string;
};

export function StatusMark(props: StatusMarkProps) {
  return (
    <Show
      when={props.awaitingPermission}
      fallback={
        <Show when={props.error}>
          <span class={statusMarkError} title={props.errorTitle ?? 'Failed'} aria-label="error">
            <IconError />
            <span aria-hidden="true">Failed</span>
          </span>
        </Show>
      }
    >
      <span class={statusMarkWarning} title="Awaiting permission" aria-label="awaiting permission">
        <IconShieldAlert />
        <span aria-hidden="true">Needs permission</span>
      </span>
    </Show>
  );
}
