/**
 * PermissionBand — surfaces an ACP permission request to the user.
 *
 * Inside ChatComposer it leads the field: the needs-you mark, what the agent
 * wants to do in words, and the decision as the one primary action (a
 * SplitButton whose menu holds the other choices). It stays unmissable
 * without a coloured fill. A "1 of N" count tells the user more are waiting.
 *
 * Tone mapping from ACP PermissionOption.kind:
 *   allow_*  → accept
 *   reject_* → reject
 *   other    → neutral
 */

import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import { SplitButton, type SplitButtonOption } from '@/react/primitives/split-button';
import { StateGlyph } from '../state-glyph/state-glyph';
import { composerThemeScope } from './composer-contract.css';
import * as styles from './permission-band.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposerPermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type ComposerPermissionRequest = {
  requestId: string;
  /** Pre-formatted action verb, e.g. "Read a File", "Execute". */
  title: string;
  options: ComposerPermissionOption[];
};

export interface PermissionBandProps {
  request: ComposerPermissionRequest;
  /** Total pending count including this one. Used to render "1 of N". */
  queueCount?: number;
  /** Called with the chosen optionId. Rejection is represented by reject_* options. */
  onResolve: (optionId: string) => void;
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function kindToTone(kind: string): SplitButtonOption['tone'] {
  if (kind.startsWith('allow_')) return 'accept';
  if (kind.startsWith('reject_')) return 'reject';
  return 'neutral';
}

function defaultSelectedId(options: ComposerPermissionOption[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind.startsWith('allow_'))?.optionId ??
    options[0]?.optionId
  );
}

// ── PermissionBand ────────────────────────────────────────────────────────────

export function PermissionBand({
  request,
  queueCount = 1,
  onResolve,
  className,
}: PermissionBandProps) {
  const splitOptions: SplitButtonOption[] = request.options.map((o) => ({
    id: o.optionId,
    label: o.name,
    tone: kindToTone(o.kind),
  }));

  const [selectedId, setSelectedId] = React.useState<string | undefined>(() =>
    defaultSelectedId(request.options)
  );

  // Reset selection when the request changes (a new request came in after resolving).
  // request.options is intentionally excluded: we only want to reset on a new request (new requestId),
  // not every time the options array reference changes while the same request is displayed.
  React.useEffect(() => {
    setSelectedId(defaultSelectedId(request.options));
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId]);

  return (
    <div
      role="group"
      aria-label="Permission request"
      className={cx(styles.band, className)}
      data-slot="permission-band"
    >
      <span className={styles.glyph}>
        <StateGlyph state="needs-you" />
      </span>

      <div className={styles.text}>
        <p className={styles.title} title={request.title}>
          {request.title}
        </p>
        <p className={styles.meta}>
          Needs your permission
          {queueCount > 1 && <span className={styles.counter}> · 1 of {queueCount}</span>}
        </p>
      </div>

      {/* The decision. Its option menu portals out of the composer root and must carry the
          theme-bridge scope. */}
      <SplitButton
        options={splitOptions}
        selectedId={selectedId}
        onSelectedChange={setSelectedId}
        onAction={onResolve}
        size="sm"
        variant="primary"
        className={styles.action}
        menuClassName={composerThemeScope}
      />
    </div>
  );
}
