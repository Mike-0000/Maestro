import { Button, Switch } from '@emdash/ui/react/primitives';
import { ArrowUpRight } from 'lucide-react';
import React from 'react';
import { PRODUCT_NAME } from '@core/primitives/app-identity/api/app-identity';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { captureTelemetry } from '@core/primitives/telemetry/browser/telemetry-client';
import { useTelemetryConsent } from '@core/primitives/telemetry/browser/useTelemetryConsent';
import { SettingRow } from './SettingRow';

const TelemetryCard: React.FC = () => {
  const { prefEnabled, envDisabled, hasKeyAndHost, loading, setTelemetryEnabled } =
    useTelemetryConsent();

  return (
    <SettingRow
      title="Usage data"
      description={
        <>
          Help improve {PRODUCT_NAME} by sending anonymous usage data.{' '}
          <Button
            type="button"
            variant="text"
            size="xs"
            className="inline-flex gap-0.5 align-baseline"
            onClick={() => openExternal('https://docs.emdash.sh/telemetry')}
          >
            What is sent
            <ArrowUpRight className="size-3" aria-hidden />
          </Button>
          {!hasKeyAndHost ? (
            <span className="mt-1 block text-tiny text-foreground-passive">
              Inactive in this build (no PostHog keys).
            </span>
          ) : null}
        </>
      }
      control={
        <Switch
          checked={prefEnabled}
          onCheckedChange={(checked) => {
            captureTelemetry('setting_changed', { setting: 'telemetry' });
            void setTelemetryEnabled(checked);
          }}
          disabled={loading || envDisabled}
          aria-label="Enable anonymous telemetry"
        />
      }
    />
  );
};

export default TelemetryCard;
