import { Button } from '@emdash/ui/react/primitives';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { useCallback, useEffect, useRef } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { confirmCommand } from '@core/features/workbench/contributions/commands';
import { ChorusMark } from '@core/primitives/app-identity/browser/chorus-logo';
import { detectPlatformContext, resolveEffectiveChord } from '@core/primitives/keybindings/api';
import { useChordKeydown } from '@core/primitives/keybindings/browser';
import { BoundShortcut } from '@core/primitives/keybindings/browser/shortcut';

const SHORTCUT_PRESS_DURATION_MS = 120;

interface WelcomeScreenProps {
  onGetStarted: () => void;
}

/**
 * The first screen after setup: the app's mark, one hero line, one sentence on what Maestro
 * is for, and the one move. Everything sits on the plain content surface; the parts fade in
 * one after another (a fade only, when the user prefers reduced motion).
 */
export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const confirmHotkey = confirmCommand.keybinding
    ? resolveEffectiveChord(confirmCommand.keybinding, keyboard ?? {}, detectPlatformContext())
    : null;
  const shortcutPressTimeoutRef = useRef<number | null>(null);
  const reduceMotion = useReducedMotion();

  const handleGetStarted = useCallback(() => {
    if (shortcutPressTimeoutRef.current !== null) {
      window.clearTimeout(shortcutPressTimeoutRef.current);
      shortcutPressTimeoutRef.current = null;
    }
    onGetStarted();
  }, [onGetStarted]);

  const handleConfirmKeyDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (shortcutPressTimeoutRef.current !== null) return;

      shortcutPressTimeoutRef.current = window.setTimeout(() => {
        handleGetStarted();
      }, SHORTCUT_PRESS_DURATION_MS);
    },
    [handleGetStarted]
  );
  useChordKeydown(confirmHotkey ?? 'Mod+Enter', handleConfirmKeyDown, {
    capture: true,
    enabled: confirmHotkey !== null,
  });

  useEffect(() => {
    return () => {
      if (shortcutPressTimeoutRef.current !== null)
        window.clearTimeout(shortcutPressTimeoutRef.current);
    };
  }, []);

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.12, delayChildren: 0.15 },
    },
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: reduceMotion ? 0 : 6 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
    },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-6">
      <motion.div
        className="flex max-w-md flex-col items-center text-center"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div variants={itemVariants}>
          <ChorusMark size={56} animated={!reduceMotion} />
        </motion.div>

        <motion.h1
          className="mt-8 text-2xl font-medium text-balance text-foreground"
          variants={itemVariants}
        >
          Welcome to Maestro
        </motion.h1>

        <motion.p
          className="mt-3 max-w-sm text-sm leading-relaxed text-balance text-foreground-muted"
          variants={itemVariants}
        >
          Run several coding agents side by side, each on its own branch, and keep track of them by
          voice or at a glance.
        </motion.p>

        <motion.div className="mt-8" variants={itemVariants}>
          <Button
            variant="primary"
            onClick={handleGetStarted}
            kbd={<BoundShortcut command="app.confirm" variant="keycaps" />}
          >
            Get started
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}
