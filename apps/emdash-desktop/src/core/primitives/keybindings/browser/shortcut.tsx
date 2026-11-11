import { Kbd, KbdGroup } from '@emdash/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import type { CommandDef } from '@core/primitives/commands/api';
import { chord, detectPlatformContext, type Chord } from '@core/primitives/keybindings/api';
import { cn } from '@core/primitives/styling/browser/cn';
import { keybindingService } from './keybinding-service';
import { keyboardLayoutService } from './keyboard-layout-service';

type ShortcutVariant = 'text' | 'badge' | 'keycaps';

/**
 * Shortcut looks (design brief 2.10 / 2.13.17):
 *  - `text`: the caption role, 11px passive with tabular figures (menu and row hints).
 *  - `badge`: the same words on one quiet neutral step, rounded-xs.
 *  - `keycaps`: one kit `Kbd` per key. Hosts tune the keycap through the Kbd hooks
 *    (`--kbd-bg`, `--kbd-border`, `--kbd-color`): Button sets them per variant and
 *    Tooltip for its surface, so no per-context overrides live here.
 */
const VARIANT_CLASS: Record<ShortcutVariant, string> = {
  text: 'inline-flex shrink-0 items-center gap-0.5 text-tiny leading-none text-foreground-passive tabular-nums',
  badge:
    'inline-flex shrink-0 items-center gap-0.5 rounded-xs bg-foreground/8 px-1.5 py-0.5 text-tiny leading-none font-medium text-foreground-muted tabular-nums',
  keycaps: 'inline-flex shrink-0 items-center gap-0.5',
};

interface ShortcutProps {
  hotkey: Chord | string | null | undefined;
  className?: string;
  variant?: ShortcutVariant;
  bare?: boolean;
}

function ShortcutKey({ keyName }: { keyName: string }) {
  return (
    <span aria-hidden="true" className="inline-block">
      {keyName}
    </span>
  );
}

/** Display a shortcut when the hotkey string is already resolved. */
function Shortcut({ hotkey, className, variant = 'text', bare = false }: ShortcutProps) {
  const [, setLayoutVersion] = useState(0);
  useEffect(
    () => keyboardLayoutService.onDidChangeLayout(() => setLayoutVersion((version) => version + 1)),
    []
  );
  const parsed = useMemo(() => {
    if (!hotkey) return null;
    try {
      return chord(hotkey);
    } catch {
      return null;
    }
  }, [hotkey]);

  if (!parsed) return null;

  const keys = keyboardLayoutService.displayLabel(parsed, detectPlatformContext());

  if (bare) {
    return (
      <KbdGroup data-slot="shortcut" role="img" aria-label={keys.join(' + ')} className={className}>
        {keys.map((key, index) => (
          <Kbd key={`${key}-${index}`} aria-hidden="true">
            <ShortcutKey keyName={key} />
          </Kbd>
        ))}
      </KbdGroup>
    );
  }

  return (
    <span
      data-slot="shortcut"
      role="img"
      aria-label={keys.join(' + ')}
      className={cn(VARIANT_CLASS[variant], className)}
    >
      {keys.map((key, index) =>
        variant === 'keycaps' ? (
          <Kbd key={`${key}-${index}`} aria-hidden="true">
            <ShortcutKey keyName={key} />
          </Kbd>
        ) : (
          <ShortcutKey key={`${key}-${index}`} keyName={key} />
        )
      )}
    </span>
  );
}

interface BoundShortcutProps {
  command: CommandDef | string;
  className?: string;
  variant?: ShortcutVariant;
  bare?: boolean;
}

/** Display a shortcut directly from an app shortcut settings key. */
const BoundShortcut = observer(function BoundShortcut({
  command,
  className,
  variant,
  bare,
}: BoundShortcutProps) {
  const hotkey = keybindingService.chordFor(typeof command === 'string' ? command : command.id);

  return <Shortcut hotkey={hotkey} className={className} variant={variant} bare={bare} />;
});

export { BoundShortcut, Shortcut, type ShortcutVariant };
