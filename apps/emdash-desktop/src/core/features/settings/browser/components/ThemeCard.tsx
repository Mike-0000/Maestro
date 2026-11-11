import { SelectableCard } from '@emdash/ui/react/primitives';
import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import React from 'react';
import type { Theme } from '@core/primitives/app-settings/api';
import { captureTelemetry } from '@core/primitives/telemetry/browser/telemetry-client';
import { useTheme } from '@core/primitives/theme/browser';

const themeOptions: Array<{
  value: Theme;
  label: string;
  ariaLabel: string;
  icon: LucideIcon;
}> = [
  { value: null, label: 'System', ariaLabel: 'Set theme to system preference', icon: Monitor },
  { value: 'emlight', label: 'Light', ariaLabel: 'Set theme to Maestro Light', icon: Sun },
  { value: 'emdark', label: 'Dark', ariaLabel: 'Set theme to Maestro Dark', icon: Moon },
];

const ThemeCard: React.FC = () => {
  const { theme, setTheme } = useTheme();

  const handleSetTheme = (next: Theme) => {
    if (theme !== next) {
      captureTelemetry('setting_changed', { setting: 'theme' });
    }
    setTheme(next);
  };

  return (
    <div className="grid grid-cols-3 gap-2">
      {themeOptions.map(({ value, label, ariaLabel, icon: Icon }) => (
        <SelectableCard
          key={label}
          selected={theme === value}
          onClick={() => handleSetTheme(value)}
          aria-label={ariaLabel}
          aria-pressed={theme === value}
          className="min-h-20"
        >
          <span className="flex flex-col items-center justify-center gap-2 px-2 py-3 text-sm">
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="text-center">{label}</span>
          </span>
        </SelectableCard>
      ))}
    </div>
  );
};

export default ThemeCard;
